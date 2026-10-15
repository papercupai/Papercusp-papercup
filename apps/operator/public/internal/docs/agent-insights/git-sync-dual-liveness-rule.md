# Git-sync dual-liveness rule
URL: /internal/docs/agent-insights/git-sync-dual-liveness-rule

Convention for long-running Git children: progress-aware child supervision and renewable resource ownership are independent safety clocks, and both must stay live for the entire operation.

## The rule

A long-running Git-sync operation is safe only while two independent liveness contracts hold:

1. **The child is making useful progress.** Network Git commands must emit an observable progress stream, refresh an idle deadline on output, and still obey an independent absolute hard ceiling.
2. **The caller still owns every resource lease.** The action must renew every held lease under the same per-fire owner for as long as the child runs, then stop renewal before releasing the leases.

Passing either contract does not imply the other. A progressing child can outlive a fixed process timeout, and it can also outlive a resource TTL. Extending only one clock either kills healthy work or permits concurrent entry into the same checkout.

## Why this exists

The physical P2P Git Mac needed a multi-gigabyte root fetch. The pre-fix hang guard killed it at the exact four-minute wall clock even though the pack had already advanced by hundreds of megabytes. With forced Git progress and an idle deadline, the final fetch continued for roughly 27 minutes and completed a roughly 4.44 GB pack.

That same healthy transfer exceeded the Git-sync resource lease TTL of 600 seconds. Without an independent lease heartbeat, the resource row could expire while the child was still running, allowing the next scheduled fire to enter the same checkout. During the successful physical run, the unique owner remained live beyond both the former four-minute process limit and the ten-minute lease limit.

## Child-progress clock

`run-git-sync.ts` treats network commands separately from local Git commands:

* `fetch`, `push`, `pull`, and `clone` receive `--progress` when the caller did not specify a progress mode. Git otherwise suppresses useful progress when stderr is piped.
* Any stdout or stderr bytes refresh the network idle timer. Silence for `PAPERCUSP_GIT_SYNC_NETWORK_TIMEOUT_MS` fails fast; the default is four minutes.
* `PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS` is a separate absolute ceiling; the default is 60 minutes. Output cannot keep a chatty but broken child alive forever.
* Local Git commands retain one ordinary wall-clock limit.

The spawner-sidecar path must preserve the same semantics: its `idleTimeoutMs` is the refreshable deadline and `timeoutMs` is the absolute ceiling. Falling back to the local child runner must not change the contract.

## Resource-ownership clock

`git-sync-action.ts` gives each fire a unique owner such as `system:git-sync:<pid>:<uuid>`, acquires the per-harness and extra resources under that owner, and refreshes them every 60 seconds against a 600-second TTL.

The heartbeat has four required properties:

* renew every acquired resource, not only the primary Git-sync resource;
* use the exact per-fire owner and coordination domain from the initial acquisition;
* allow at most one refresh pass in flight, so a slow lock-store round trip cannot build an interval backlog;
* stop the interval and await any in-flight refresh before releasing resources.

A stable owner shared by cron and manual `git-sync:run` is incorrect: same-owner acquisition coalesces into a refresh, so two distinct fires could enter concurrently. The UUID owner makes the second fire take the foreign-owner conflict path and skip.

## Abort and child-exit boundary

An action timeout requests cancellation; it does not prove that a Git child has exited. While tracked Git executions remain unresolved, `recordTimeoutActivity` reports the error with `active:true` and `completed_at:null`. Lease renewal continues until those executions settle. Cleanup then stops renewal, records the terminal error while the fire still owns its leases, and releases the resources.

A non-timeout pipeline rejection has the same boundary. The maintained protected-path preflight runs Git commands in parallel with `Promise.all`; one rejection can propagate while another tracked command remains unresolved. The generic error marker therefore also stays active until cleanup observes that remaining work settle. Cleanup preserves the original pipeline error.

This marker is a safety boundary: `routines:list` derives its execution verdict and `safe_to_restart` from activity. Publishing `active:false` at the cancellation deadline or the first parallel rejection would describe a still-running child as idle. The deferred-child timeout and parallel generic-error resolve/reject cases in `git-sync-action.test.ts` reproduced both errors in EI-25430105870893148 and guard the pending and terminal states.

An inactive marker is also not an independent resource-release receipt. Correlate its exact per-fire owner with the resource hold and require the sanctioned drain before restarting. A refreshed acquisition timestamp measures a lease refresh, not the full age of a hold.

## Recurrence guards

Keep all of these tests when the runner, sidecar, lock store, or routine wrapper changes:

* `git-sync-checkpoint-resume.test.ts`: a network child emitting progress outlives the old wall clock and receives `--progress`.
* `git-sync-checkpoint-resume.test.ts`: an endlessly chatty child is still killed by the absolute hard ceiling.
* `git-via-sidecar.test.ts`: the sidecar refreshes its idle deadline on output and kills a silent child at the idle deadline.
* `git-sync-action.test.ts`: every held resource is renewed after 60 seconds with the same owner and 600-second TTL, renewal stops before release, and a concurrent fire gets a distinct owner and cannot enter.
* `git-sync-action.test.ts`: timeouts and parallel generic errors retain an active marker and renewable leases until tracked Git settles, then publish terminal activity before releasing resources.

## Operator evidence

When validating a real long transfer, observe both clocks rather than inferring safety from a single artifact:

* child clock: exact PID, elapsed time, pack-file byte growth or Git progress output, and the terminal Git result;
* resource clock: exact per-fire owner, unchanged ownership across the run, lease-expiry advancement, and proof that an overlapping fire skipped;
* completion: the persisted Git-sync writer outcome plus repository ancestry/census, not process exit alone.

If bytes advance but the lease owner disappears, the operation is unsafe. If the lease renews but bytes and output are silent past the idle deadline, the operation is wedged. Only both live signals establish a healthy in-flight Git-sync.
